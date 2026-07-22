import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/pg.js', () => ({ query: vi.fn() }));
import { query } from '../../lib/pg.js';
import { pgFind, pgGenres, pgTrackById } from '../../lib/catalog-store-pg.js';

// Capture the SQL + params of the most recent query call.
const lastCall = () => query.mock.calls[query.mock.calls.length - 1];

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('pgFind — FileMaker _find → SQL translation', () => {
  it('contains *x* → ILIKE %x%', async () => {
    await pgFind([{ 'Album Title': '*love*' }], { limit: 10 });
    const [sql, params] = lastCall();
    expect(sql).toMatch(/raw->>\$1 ILIKE \$2/);
    expect(params).toContain('Album Title');
    expect(params).toContain('%love%');
  });

  it('begins x* → ILIKE x%   and   ends *x → ILIKE %x', async () => {
    await pgFind([{ 'Album Artist': 'lucky*' }]);
    expect(lastCall()[1]).toContain('lucky%');
    await pgFind([{ 'Album Artist': '*dube' }]);
    expect(lastCall()[1]).toContain('%dube');
  });

  it('exact ==x → lower() equality on the whole value (no tokenising)', async () => {
    await pgFind([{ 'PublicPlaylist': '==Summer Hits' }]);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/lower\(raw->>\$1\) = \$2/);
    expect(params).toContain('summer hits');
  });

  it('range a..b → numeric BETWEEN with a digit guard', async () => {
    await pgFind([{ 'Year of Release': '1980..1989' }]);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/BETWEEN \$\d+::int AND \$\d+::int/);
    expect(params).toContain('1980');
    expect(params).toContain('1989');
  });

  it('non-empty * → IS NOT NULL AND <> \'\'', async () => {
    await pgFind([{ 'PublicPlaylist': '*' }]);
    expect(lastCall()[0]).toMatch(/IS NOT NULL AND raw->>\$1 <> ''/);
  });

  it('multi-token *w* *w* (free-text contains) ANDs each substring', async () => {
    await pgFind([{ 'Album Title': '*lucky* *dube*' }]);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/ILIKE \$\d+ AND raw->>\$\d+ ILIKE/);
    expect(params).toContain('%lucky%');
    expect(params).toContain('%dube%');
  });

  it('REGRESSION: starred phrase "*Afro Folk*" is ONE whole-phrase contains', async () => {
    // Genre filters build `*${genre}*` around the WHOLE genre name. This used
    // to fall through to the prefix fallback, which kept the leading star as a
    // literal (ILIKE '*Afro Folk%') → zero rows for every multi-word genre.
    await pgFind([{ 'Local Genre': '*Afro Folk*' }]);
    const params = lastCall()[1];
    expect(params).toContain('%Afro Folk%');
    expect(params.some((p) => typeof p === 'string' && p.startsWith('*'))).toBe(false);
  });

  it('REGRESSION: multi-word begins "phrase*" is ONE whole-prefix, not split', async () => {
    // begins("Soul Brothers") = "Soul Brothers*" — must NOT become %Soul% AND Brothers%
    await pgFind([{ 'Album Artist': 'Soul Brothers*' }]);
    const [sql, params] = lastCall();
    expect(sql).not.toMatch(/ AND /);            // single condition
    expect(params).toContain('Soul Brothers%');  // whole-phrase prefix
    expect(params).not.toContain('%Soul%');
  });

  it('REGRESSION: plain multi-word value is a whole-prefix, not per-word substrings', async () => {
    // /api/album?title=U Hlaza — "%U%" used to match everything → wrong album
    await pgFind([{ 'Album Title': 'U Hlaza' }]);
    const [sql, params] = lastCall();
    expect(sql).not.toMatch(/ AND /);
    expect(params).toContain('U Hlaza%');
    expect(params).not.toContain('%U%');
  });

  it('multiple query objects OR together; fields within an object AND', async () => {
    await pgFind([{ 'Album Title': 'x*', 'Album Artist': 'y*' }, { 'Track Name': 'z*' }]);
    const sql = lastCall()[0];
    expect(sql).toMatch(/ AND /);  // within first object
    expect(sql).toMatch(/ OR /);   // between objects
  });

  it('escapes LIKE wildcards in user values', async () => {
    await pgFind([{ 'Album Title': '*50%_off*' }]);
    expect(lastCall()[1]).toContain('%50\\%\\_off%');
  });

  it('returns FM-shaped records + foundCount from the window count', async () => {
    query.mockResolvedValueOnce({ rows: [
      { fm_record_id: '7', fm_mod_id: 3, raw: { 'Track Name': 'A' }, __total: '42' },
    ] });
    const { ok, data, foundCount } = await pgFind([{ 'Album Title': '*' }]);
    expect(ok).toBe(true);
    expect(foundCount).toBe(42);
    expect(data[0]).toEqual({ recordId: '7', modId: '3', fieldData: { 'Track Name': 'A' } });
  });

  it('clamps limit and converts FM 1-based offset to SQL 0-based', async () => {
    await pgFind([{ 'Album Title': '*' }], { limit: 99999, offset: 5 });
    const params = lastCall()[1];
    expect(params).toContain(2000); // clamped limit
    expect(params).toContain(4);    // offset 5 → OFFSET 4
  });
});

describe('pgGenres / pgTrackById', () => {
  it('pgGenres returns distinct, locale-sorted genres + count', async () => {
    query.mockResolvedValueOnce({ rows: [{ genre: 'Soul' }, { genre: 'Afro Folk' }, { genre: 'mbaqanga' }] });
    query.mockResolvedValueOnce({ rows: [{ c: '63614' }] });
    const out = await pgGenres();
    expect(out.genres).toEqual(['Afro Folk', 'mbaqanga', 'Soul'].sort((a, b) => a.localeCompare(b)));
    expect(out.foundCount).toBe(63614);
  });

  it('pgTrackById returns a record or null', async () => {
    query.mockResolvedValueOnce({ rows: [{ fm_record_id: '9', fm_mod_id: 1, raw: { x: 1 } }] });
    expect(await pgTrackById('9')).toMatchObject({ recordId: '9' });
    query.mockResolvedValueOnce({ rows: [] });
    expect(await pgTrackById('404')).toBeNull();
  });
});
