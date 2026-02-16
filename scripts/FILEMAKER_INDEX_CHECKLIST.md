# FileMaker Index Status Checklist

## Quick Manual Check (5 minutes)

### Method 1: Visual Inspection (Easiest)

1. Open your FileMaker database
2. Go to **File → Manage → Database** (Cmd+Shift+D / Ctrl+Shift+D)
3. Click the **Fields** tab
4. Select your table (probably "Tape Files" or "API_Album_Songs")
5. For each field below, check if it's indexed:
   - Select the field
   - Click **Options** button
   - Go to **Storage** tab
   - Look for **Indexing** section
   - Should show: "☑ Automatically create indexes when needed"

---

## 🔥 Priority 1: CRITICAL INDEXES (Check These First)

These fields are queried on **every single search request**:

### Primary Search Fields
- [ ] **Album Artist** - ✅ Indexed?
- [ ] **Album Title** - ✅ Indexed?
- [ ] **Track Name** - ✅ Indexed?
- [ ] **Track Artist** - ✅ Indexed?

**Impact if missing:** 5-10x slower searches

---

## ⚡ Priority 2: HIGH-IMPACT INDEXES

### Genre Discovery (Discover by Genre feature)
- [ ] **Local Genre** - ✅ Indexed?
- [ ] **Genre** - ✅ Indexed?

**Impact if missing:** 4-8x slower genre searches

### Visibility Filter (Used on ALL queries)
- [ ] **Visibility** (or your FM_VISIBILITY_FIELD name) - ✅ Indexed?
- [ ] **Tape Files::Visibility** - ✅ Indexed? (if using related table)

**Impact if missing:** 2-3x slower overall

---

## 📊 Priority 3: VALIDATION INDEXES

These are checked for every result returned:

### Audio Validation
- [ ] **mp3** - ✅ Indexed?
- [ ] **MP3** - ✅ Indexed?
- [ ] **Audio File** - ✅ Indexed?
- [ ] **Audio::mp3** - ✅ Indexed?

### Artwork Validation
- [ ] **Artwork::Picture** - ✅ Indexed?
- [ ] **Artwork Picture** - ✅ Indexed?
- [ ] **Picture** - ✅ Indexed?

**Impact if missing:** 20-30% slower result filtering

---

## 📁 Priority 4: LOOKUP INDEXES

### Catalogue Lookups
- [ ] **Album Catalogue Number** - ✅ Indexed?
- [ ] **Tape Files::Album Catalogue Number** - ✅ Indexed?
- [ ] **Reference Catalogue Number** - ✅ Indexed?
- [ ] **Tape Files::Reference Catalogue Number** - ✅ Indexed?

**Impact if missing:** Slower album page loads

---

## 📈 Priority 5: ANALYTICS INDEXES

### Trending Calculations
- [ ] **TimestampUTC** - ✅ Indexed?

**Impact if missing:** Slower trending calculations (but these are cached for 24 hours)

---

## Method 2: FileMaker Data Viewer Check

If you have **FileMaker Pro Advanced**, use the Data Viewer:

1. Open **Tools → Data Viewer** (Cmd+Option+D)
2. Switch to **Watch** tab
3. Add this calculation for each field:

```
FieldRepetitions ( Get ( FileName ) ; "Album Artist" )
```

- If returns **0** = Field doesn't exist
- If returns **1+** = Field exists (then manually check indexing)

---

## Method 3: Database Design Report (Most Thorough)

1. Go to **Tools → Database Design Report** (DDR)
2. Select your database file
3. Check **Include field definitions**
4. Click **Create**
5. Open the generated HTML report
6. Search for your field names
7. Look for **"Storage: Indexed"** or **"Index: None"**

---

## How to Enable Indexing

If a field is **NOT indexed**:

1. Select the field in Manage Database
2. Click **Options**
3. Go to **Storage** tab
4. In the **Indexing** section:
   - ☑ Check **"Automatically create indexes when needed"**
   - Choose language: **English** (or your database language)
   - Choose index type: **Minimal words** (for text fields)
5. Click **OK**
6. Click **OK** again to close Manage Database
7. **Important:** FileMaker will now index the field, which may take a few minutes for large databases

---

## Verification After Indexing

1. Run a search in MASS (e.g., search for an artist)
2. Check server logs - should be **much faster**
3. Genre discovery should load in **1-2 seconds** instead of 5-10 seconds

---

## Expected Results

### Before Indexing
```
[SEARCH] Query took 8500ms
[Genre Filter] Query took 12000ms
```

### After Indexing
```
[SEARCH] Query took 250ms (34x faster!)
[Genre Filter] Query took 800ms (15x faster!)
```

---

## Notes

- **Container fields** (mp3, Picture) may show "Not indexable" - this is normal
  - For audio/artwork validation, index a **calculation field** instead:
    - Create field: `HasAudio` = `not IsEmpty ( mp3 )`
    - Index the calculation field
    - Modify search queries to filter by `HasAudio = 1`

- **Related fields** (Tape Files::*) should be indexed in their **source table**

- **Indexing uses disk space** but provides massive performance gains
  - A 10GB database might use 500MB-1GB extra for indexes
  - Worth it for 10-50x query speedup

---

## Quick Test

After indexing, run this in MASS and check the logs:

1. Search for an artist: "Bea"
2. Check console logs for timing
3. Should see `[CACHE MISS]` first time, then instant `[CACHE HIT]` after

If still slow after indexing, the issue may be:
- FileMaker Server hardware
- Network latency
- The port 8989 connection issue you're seeing
