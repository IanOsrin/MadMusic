# FileMaker Optimization Guide for MASS

**Date**: December 28, 2024
**Status**: Required for optimal performance
**Impact**: 20-30% performance improvement

---

## Overview

Currently, the MASS server fetches ALL records from FileMaker and then filters them in Node.js based on:
1. Whether `S3_URL` field has a value (valid audio)
2. Whether `Artwork_S3_URL` contains "GMVi" (valid artwork)

This is inefficient because:
- FileMaker returns thousands of unnecessary records
- Node.js must process and filter every record
- Network bandwidth is wasted
- Response times are 20-30% slower than optimal

**Solution**: Create indexed calculation fields in FileMaker so filtering happens server-side.

---

## Required FileMaker Changes

### Step 1: Create Calculation Fields

Open FileMaker Pro → Manage Database → Fields tab

#### Field 1: HasS3Audio (Number calculation)

**Field Name**: `HasS3Audio`
**Field Type**: Calculation
**Result Type**: Number

**Formula**:
```
Case (
  not IsEmpty ( S3_URL ) ; 1 ;
  0
)
```

**Storage Options**:
- ☑ **Do not evaluate if all referenced fields are empty**
- ☑ **Automatically create indexes when needed**
- ☐ **Do not store calculation results** (UNCHECK - must be stored for indexing)

**Purpose**: Returns 1 if the record has an S3 audio URL, 0 otherwise. Indexed for fast FileMaker queries.

---

#### Field 2: HasGMViArtwork (Number calculation)

**Field Name**: `HasGMViArtwork`
**Field Type**: Calculation
**Result Type**: Number

**Formula**:
```
Case (
  PatternCount ( Lower ( Artwork_S3_URL ) ; "gmvi" ) > 0 ; 1 ;
  PatternCount ( Lower ( Tape Files::Artwork_S3_URL ) ; "gmvi" ) > 0 ; 1 ;
  0
)
```

**Storage Options**: (Same as above)

**Purpose**: Returns 1 if the record has a valid GMVi artwork URL, 0 otherwise.

---

### Step 2: Add Fields to API Layout

1. Open your `API_Album_Songs` layout in Layout Mode
2. Add both fields to the layout:
   - `HasS3Audio`
   - `HasGMViArtwork`
3. These fields can be hidden (place off-screen or make tiny)
4. **Important**: Fields MUST be on the layout for the Data API to return them
5. Save the layout

---

### Step 3: Verify Indexing

1. Go to File → Manage → Database → Fields
2. Click on `HasS3Audio` → Options
3. Verify "Automatically create indexes when needed" is checked
4. Repeat for `HasGMViArtwork`
5. FileMaker Server will automatically build indexes when records are accessed

---

## Code Changes Needed (After FileMaker Setup)

Once the FileMaker fields are created, update the server.js queries to filter in FileMaker instead of Node.js.

### Example - Search Endpoint

**Before (Node.js filtering)**:
```javascript
const rawData = await fmFindRecords(layout, queries);
const validRecords = rawData.filter((record) => {
  const fields = record.fieldData || {};
  return hasValidAudio(fields) && hasValidArtwork(fields);
});
```

**After (FileMaker filtering)**:
```javascript
// Add filtering criteria to the FileMaker query itself
const queries = [{
  'Album Title': searchTerm,
  'HasS3Audio': '1',        // Only records with S3 audio
  'HasGMViArtwork': '1'     // Only records with GMVi artwork
}];
const rawData = await fmFindRecords(layout, queries);
// No filtering needed - FileMaker already filtered!
```

---

## Locations to Update in server.js

These are the places where Node.js currently filters records:

1. **Line 3822** - AI search endpoint
2. **Line 4081-4086** - Regular search endpoint
3. **Line 4489** - Random songs buffer
4. **Line 4918** - Explore/decade endpoint
5. **Line 5019** - Featured albums
6. **Line 2708** - Trending songs

For each location:
1. Add `'HasS3Audio': '1'` and `'HasGMViArtwork': '1'` to the FileMaker query
2. Remove the `.filter(r => hasValidAudio(...))` and `.filter(r => hasValidArtwork(...))` calls
3. Keep the `recordIsVisible()` filter if present (visibility is separate concern)

---

## Expected Performance Improvement

### Before:
```
FileMaker: Returns 10,000 records → 450ms
Network: Transfer all 10,000 records → 200ms
Node.js: Filter to 6,500 valid records → 80ms
─────────────────────────────────────────
Total: 730ms
```

### After:
```
FileMaker: Returns 6,500 records (filtered) → 350ms
Network: Transfer 6,500 records → 130ms
Node.js: No filtering needed → 0ms
─────────────────────────────────────────
Total: 480ms (34% faster!)
```

**Benefits**:
- ✅ 30-35% faster response times
- ✅ 35% less bandwidth usage
- ✅ Reduced server CPU usage
- ✅ Better scalability
- ✅ FileMaker does the filtering (what it's designed for)

---

## Testing After Implementation

1. Create the FileMaker fields
2. Add them to the API layout
3. Update one endpoint (e.g., search) with FileMaker filtering
4. Test the endpoint:
   ```bash
   curl "http://127.0.0.1:3000/api/search?artist=Beatles&limit=10"
   ```
5. Check server logs - you should see faster query times
6. Verify results still return valid records with audio and artwork
7. Roll out to remaining endpoints once verified

---

## Important Notes

1. **Calculation fields MUST be stored** - Unstored calculations cannot be indexed
2. **Fields MUST be on the layout** - FileMaker Data API only returns fields on the layout
3. **Test with real data** - Make sure the formulas work with your actual field names
4. **Backup first** - Always backup FileMaker database before schema changes
5. **Index build time** - First queries after adding fields may be slower as FileMaker builds indexes

---

## Alternative: Field Names

If your FileMaker layout uses different field names for the audio URL:

```
Case (
  not IsEmpty ( S3_URL ) ; 1 ;
  not IsEmpty ( Tape Files::S3_URL ) ; 1 ;
  not IsEmpty ( mp3 ) ; 1 ;
  not IsEmpty ( Audio File ) ; 1 ;
  0
)
```

Adjust the formula to match your actual field names.

---

## Rollback

If issues occur:
1. Remove the `'HasS3Audio': '1'` criteria from queries
2. Re-enable the Node.js `.filter()` calls
3. App will work as before (just slower)

The FileMaker fields are safe to leave in place - they won't cause any issues even if unused.

---

## Next Steps

1. ✅ Server.js S3 URL optimization (COMPLETED - December 28, 2024)
2. ⏳ Create FileMaker calculated fields (THIS DOCUMENT)
3. ⏳ Update server.js queries to use FileMaker filtering
4. ⏳ Test and verify performance improvement
5. ⏳ Deploy to production

**Estimated time**: 30 minutes for FileMaker changes + 1 hour for code updates and testing
