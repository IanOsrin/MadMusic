# Container Field Optimization Guide

## Problem
Container fields (mp3, Picture) cannot be directly indexed in FileMaker, but we need to filter records based on whether they have audio/artwork.

## Current Behavior
- FileMaker returns ALL records
- Node.js filters them with `hasValidAudio()` and `hasValidArtwork()`
- This is SLOW because FileMaker sends unnecessary data

## Solution: Indexed Calculation Fields

### Step 1: Create Calculation Fields in FileMaker

Open FileMaker Pro → File → Manage → Database → Fields

#### HasAudio (Number calculation)
```
Case (
  not IsEmpty ( mp3 ) ; 1 ;
  not IsEmpty ( Audio File ) ; 1 ;
  not IsEmpty ( Audio::mp3 ) ; 1 ;
  0
)
```

**Settings:**
- Result Type: **Number**
- Storage Options:
  - ☑ **Do not evaluate if all referenced fields are empty**
  - ☑ **Automatically create indexes when needed**
  - ☐ **Do not store calculation results** (UNCHECK THIS - we want it stored and indexed)

#### HasArtwork (Number calculation)
```
Case (
  not IsEmpty ( Artwork::Picture ) ; 1 ;
  not IsEmpty ( Picture ) ; 1 ;
  not IsEmpty ( Artwork Picture ) ; 1 ;
  not IsEmpty ( CoverArtURL ) ; 1 ;
  0
)
```

**Settings:** Same as HasAudio

### Step 2: Add to Your API Layout

1. Open your `API_Album_Songs` layout
2. Add these fields to the layout (they can be hidden)
3. Save the layout

### Step 3: Update server.js Queries

Instead of filtering in Node.js, filter in FileMaker queries:

#### Before (slow - filters after fetching):
```javascript
const rawData = await fmFindRecords(layout, queries);
const filtered = rawData.filter(r => hasValidAudio(r.fields) && hasValidArtwork(r.fields));
```

#### After (fast - FileMaker filters before sending):
```javascript
// Add to query
const queries = [{
  'Album Title': 'Abbey*',
  'HasAudio': '1',
  'HasArtwork': '1'
}];
const rawData = await fmFindRecords(layout, queries);
// No filtering needed - FileMaker already filtered!
```

### Step 4: Update Code

Find all places where we filter by `hasValidAudio` and `hasValidArtwork` in server.js:

**Lines to modify:**
- server.js:3836 (AI search)
- server.js:4094 (Regular search)
- server.js:4746 (Random song buffer)
- server.js:4919 (Persisted random songs)
- server.js:5137 (Featured albums)
- server.js:5304 (Playlist seeds)
- server.js:5623 (Random song selection)

**Example modification:**

```javascript
// OLD WAY (Node.js filtering)
const validRecords = rawData.filter((record) => {
  const fields = record.fieldData || {};
  return hasValidAudio(fields) && hasValidArtwork(fields);
});

// NEW WAY (FileMaker filtering)
// Add to the query itself:
const payload = {
  query: [
    {
      'Album Title': '*',
      'HasAudio': '1',
      'HasArtwork': '1'
    }
  ],
  limit: 100
};
const response = await fmPost(`/layouts/${layout}/_find`, payload);
// FileMaker already filtered - no Node.js filtering needed!
```

## Expected Performance Improvement

### Before:
- FileMaker returns 1000 records (500ms)
- Node.js filters to 750 records (50ms)
- Total: **550ms**

### After:
- FileMaker returns 750 records already filtered (400ms)
- No Node.js filtering needed (0ms)
- Total: **400ms**
- Plus: **Saves bandwidth** (250 fewer records transmitted)

## Important Notes

1. **Calculation fields must be STORED** (not unstored) to be indexed
2. **Add fields to the API layout** or they won't be available
3. **Test the calculations** - make sure they return 1/0 correctly
4. **Update related tables** if using Tape Files relationships
5. **FileMaker Server will auto-index** when you check the box

## Alternative: Use FileMaker's Built-in isEmpty()

If you prefer to keep filtering in Node.js but want it faster:

In your API layout, add a **script trigger** on record load that sets:
- `g_HasAudio` (global field) = `not IsEmpty(mp3)`
- `g_HasArtwork` (global field) = `not IsEmpty(Picture)`

Then query these global fields instead of checking containers.

## Don't Do This

❌ **Don't create unstored calculations** - they won't be indexed
❌ **Don't forget to add to the layout** - FileMaker only sends fields on the layout
❌ **Don't use text fields** - use Number (0/1) for indexing efficiency

## Testing

After implementing:

```bash
# Test search speed
curl "http://127.0.0.1:3000/api/search?artist=Beatles"

# Check server logs
# Should see faster query times and less filtering overhead
```

Expected improvement: **20-40% faster** by reducing data transfer and Node.js filtering overhead.
