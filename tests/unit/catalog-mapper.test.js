import { describe, it, expect } from 'vitest';
import { mapRecordToRow, buildUpsertQuery, TRACK_COLUMNS } from '../../lib/catalog-mapper.js';

// A compilation track: album artist differs from the track artist. The grouping
// column MUST take the album artist (INVARIANT #1) or compilations fragment.
const COMPILATION = {
  recordId: '101',
  modId: '7',
  fieldData: {
    'Album Title': 'Township Jive Vol 1',
    'Album Artist': 'Various Artists',
    'Track Artist': 'Mahlathini',
    'Track Name': 'Indoda Mahlathini',
    'Local Genre': 'Mbaqanga',
    'Album Catalogue Number': 'GMVi4460',
    'Track Number': '3',
    'Duration': '00:03:45',
    'Year of Release': '1985',
    'Visibility': 'Show',
    'S3_URL': 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/audio/GMVi4460-03.mp3',
    'Artwork_S3_URL': 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/GMVi4460.jpg',
    'Tape Files::featured': 'yes',
    'G100_Highlights': 'Yes',
    'Tape Files::Singles': 'Yes',
    'Global_Favorites': 'Yes',
  },
};

describe('mapRecordToRow', () => {
  const row = mapRecordToRow(COMPILATION);

  it('uses the ALBUM artist for the grouping column, the TRACK artist for display', () => {
    expect(row.album_artist).toBe('Various Artists');
    expect(row.track_artist).toBe('Mahlathini');
  });

  it('maps identity + catalogue + sequence', () => {
    expect(row.fm_record_id).toBe('101');
    expect(row.album_title).toBe('Township Jive Vol 1');
    expect(row.track_title).toBe('Indoda Mahlathini');
    expect(row.genre).toBe('Mbaqanga');
    expect(row.catalogue_no).toBe('GMVi4460');
    expect(row.track_seq).toBe(3);
  });

  it('maps stable S3 URLs (audio + artwork)', () => {
    expect(row.s3_audio_url).toContain('.s3.');
    expect(row.s3_audio_url).toMatch(/\.mp3$/);
    expect(row.s3_artwork_url).toMatch(/\.jpg$/);
  });

  it('resolves all four flags', () => {
    expect(row.is_featured).toBe(true);
    expect(row.is_g100).toBe(true);
    expect(row.is_single).toBe(true);
    expect(row.is_global_fav).toBe(true);
  });

  it('parses duration HH:MM:SS into seconds and year to int', () => {
    expect(row.duration_secs).toBe(3 * 60 + 45);
    expect(row.release_year).toBe(1985);
  });

  it('captures Visibility, and extracts the year from an Original Release date fallback', () => {
    expect(row.visibility).toBe('Show');
    const r = mapRecordToRow({ recordId: '9', fieldData: { 'Original Release date': '1992-02-12' } });
    expect(r.release_year).toBe(1992);
  });

  it('captures modId and preserves full fieldData in raw', () => {
    expect(row.fm_mod_id).toBe(7);
    expect(row.raw).toBe(COMPILATION.fieldData);
  });

  it('drops corrupt "N:00:00" durations to null', () => {
    const r = mapRecordToRow({ recordId: '1', fieldData: { 'Duration': '5:00:00' } });
    expect(r.duration_secs).toBeNull();
  });

  it('flags are false when the field is absent or not the magic value', () => {
    const r = mapRecordToRow({ recordId: '2', fieldData: { 'Tape Files::Singles': 'no' } });
    expect(r.is_single).toBe(false);
    expect(r.is_featured).toBe(false);
    expect(r.is_g100).toBe(false);
  });

  it('falls back through artist candidates when no Track Artist', () => {
    const r = mapRecordToRow({ recordId: '3', fieldData: { 'Artist': 'Solo Star', 'Album Title': 'X' } });
    expect(r.track_artist).toBe('Solo Star');
    expect(r.album_artist).toBe('Solo Star');
  });

  it('returns null for a record with no recordId', () => {
    expect(mapRecordToRow({ fieldData: {} })).toBeNull();
    expect(mapRecordToRow(null)).toBeNull();
  });

  it('leaves unknown optional fields null (not undefined)', () => {
    const r = mapRecordToRow({ recordId: '4', fieldData: {} });
    expect(r.album_title).toBeNull();
    expect(r.s3_audio_url).toBeNull();
    expect(r.track_seq).toBeNull();
  });
});

describe('buildUpsertQuery', () => {
  const rows = [mapRecordToRow(COMPILATION), mapRecordToRow({ recordId: '102', fieldData: { 'Album Title': 'Y' } })];
  const stamp = new Date('2026-06-29T12:00:00Z');

  it('returns null for an empty batch', () => {
    expect(buildUpsertQuery([], stamp)).toBeNull();
    expect(buildUpsertQuery(null, stamp)).toBeNull();
  });

  it('builds an INSERT ... ON CONFLICT upsert with one tuple per row', () => {
    const { text, params } = buildUpsertQuery(rows, stamp);
    expect(text).toMatch(/^INSERT INTO tracks \(/);
    expect(text).toContain('ON CONFLICT (fm_record_id) DO UPDATE SET');
    expect(text).toContain('album_title = EXCLUDED.album_title');
    expect(text).not.toContain('fm_record_id = EXCLUDED.fm_record_id'); // PK not updated
    // one placeholder set per column per row
    expect(params).toHaveLength(TRACK_COLUMNS.length * rows.length);
  });

  it('casts raw to jsonb and serialises it as text', () => {
    const { text, params } = buildUpsertQuery([rows[0]], stamp);
    expect(text).toMatch(/\$\d+::jsonb/);
    const rawParam = params[TRACK_COLUMNS.indexOf('raw')];
    expect(typeof rawParam).toBe('string');
    expect(JSON.parse(rawParam)['Album Title']).toBe('Township Jive Vol 1');
  });

  it('stamps every row synced_at with the run timestamp', () => {
    const { params } = buildUpsertQuery(rows, stamp);
    const syncedIdx = TRACK_COLUMNS.indexOf('synced_at');
    expect(params[syncedIdx]).toBe(stamp);
    expect(params[TRACK_COLUMNS.length + syncedIdx]).toBe(stamp);
  });
});
