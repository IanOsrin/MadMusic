---
name: mad-fm-dedup-pattern
description: Applies the FileMaker album/track dedup pattern when building any MAD Streamer route that returns album rail data. Use when working on routes/catalog/*, routes/charts.js, routes/playlists.js, or any future route fetching FM records that should render as one card per album. Trigger on: "MAD route", "FileMaker query", "album rail", "catalog route", "fm-client", "duplicate covers", "one row per track problem", "dedupe", or any file path containing "routes/catalog/" in the MadMusicV3.0 project.
---

# MAD FileMaker Album Dedup Pattern

## The problem

FileMaker layouts in the MAD Streamer commonly return **one row per track**
even when the consumer (album rail, grid, hero carousel) wants **one card per
album**. Without dedup, a 12-card rail shows the same compilation cover 12
times — visually broken, looks like a render bug. This was the root cause of
the "1973 Inqaba Yase Sotho repeated 7×" issue fixed on 2026-05-21 (commit
8474b5c).

## The helper (canonical implementation)

Located in `routes/catalog/featured.js`. Copy this pattern verbatim when
writing new album-rail endpoints:

```javascript
// FM commonly returns one row per track, so a 400-record fetch can be 20
// albums × 20 tracks each. Use on any rail/grid that should show ONE card
// per album (Classics, Highlighted Albums, Originals, etc.). Without this,
// "The Classics" can render the same compilation cover 7 times in a row.
function dedupRecordsByAlbum(records = []) {
  const seen = new Set();
  const out  = [];
  for (const r of records) {
    const f      = r.fieldData || r.fields || {};
    const artist = (f['Album Artist'] || f['Tape Files::Album Artist'] || '').toLowerCase().trim();
    const album  = (
      f['Album Title']
      || f['Tape Files::Album Title']
      || f['Tape Files::Album_Title']
      || ''
    ).toLowerCase().trim();
    const key    = album ? `${artist}|||${album}` : r.recordId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
```

## Where to apply it

Apply inside the **SWR loader**, before the records are shaped for the
response. This way the dedup happens once per cache fill (10-min TTL), not
per request:

```javascript
const featuredSwr = createSwrCache({
  ttlMs: FEATURED_TTL_MS,
  max:   4,
  label: 'featured',
  name:  'featured',
  loader: async () => {
    const records = await fetchFeaturedAlbumRecords(400);
    const deduped = dedupRecordsByAlbum(records);    // ← apply here
    log.debug(`Featured: ${deduped.length} unique albums from ${records.length} tracks`);
    return deduped.map(r => ({
      recordId: r.recordId, modId: r.modId, fields: r.fieldData || {}
    }));
  }
});
```

## The field name fallback chain

FileMaker layouts in MAD use mixed field naming — sometimes plain
(`Album Title`), sometimes namespaced (`Tape Files::Album Title`), sometimes
with underscores (`Tape Files::Album_Title`). Always check all three:

```
Album:  'Album Title' | 'Tape Files::Album Title' | 'Tape Files::Album_Title'
Artist: 'Album Artist' | 'Tape Files::Album Artist'
Art:    'Artwork_S3_URL' | 'Tape Files::Artwork_S3_URL'
Audio:  'mp3' | 'audio' | 'Tape Files::Audio_S3_URL'  (see lib/fm-fields.js)
```

Refer to `lib/fm-fields.js` for the canonical FIELD_CANDIDATES constants.

## When NOT to apply this

- **Track-level endpoints** (e.g. a track listing within an album page) —
  one row per track is the desired shape.
- **Chart endpoints** — already keyed by `track_record_id`; deduping by
  album would collapse multiple tracks from the same album in the charts,
  which is wrong (a hit album SHOULD have multiple tracks charting).
- **Search results** — track-level granularity is expected.

## Routes that currently apply this (as of 2026-05-21)

- `routes/catalog/featured.js`:
  - `featuredSwr.loader` ✓ (Phase 1 fix)
  - `newReleasesSwr.loader` ✓ (pre-existing — inline dedup that this helper
    consolidates; can be refactored to use the shared helper)
  - `g100Swr.loader` ✓ (Phase 1 fix)

## Future considerations

When the RSS surfaces are built (`Just Dropped` from labels, `Editorial`,
`Shows` per the multi-source RSS scope), the same problem may surface if
RSS items map 1:N onto albums. Apply the same pattern with RSS-appropriate
keys (e.g., guid+pubDate).

## Validation

After applying, log the before/after count to confirm:
```
log.debug(`<rail>: ${deduped.length} unique albums from ${records.length} tracks`);
```

If `deduped.length === records.length`, either FM is already returning
one row per album OR the field name fallback isn't matching — verify by
inspecting `records[0].fieldData` in the logs.
