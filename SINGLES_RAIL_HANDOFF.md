# Singles rail — debug handoff for Claude Code

## Goal
A horizontal **"Singles"** rail on the home page (`app.html`), one card per **track**, populated from a FileMaker checkbox field **`singles`** (stored value `"Yes"`) that lives on the **Tape Files** table. Clicking a card plays the track through the existing player. The rail already exists in code but **does not appear when running locally**, even after the `singles` field was added in FileMaker.

## Stack / facts you need
- Express 5, ES modules, Node ≥18. Entry: `server.js` (single) or `cluster.js`. Run locally in **dev** (`NODE_ENV` not `production`) — in production mode `app.html` is cached in memory and edits won't show without a restart.
- FileMaker Data API. Credentials in `.env`: `FM_HOST`, `FM_DB` (`MADStreamer`), `FM_USER`, `FM_PASS`, `FM_LAYOUT` (`API_Album_Songs`).
- **Key constraint:** the Data API can only query/return fields that are physically placed on the **`API_Album_Songs`** layout. As of the last external check, a field dump of that layout (via `/api/search`) showed `Tape Files::Featured`, `Tape Files::G100_Highlights`, `Tape Files::Artwork_S3_URL`, etc. — **but no `singles` / `Tape Files::singles`**. The user says they have since added it; please verify directly (see Step 3).
- FM client helpers (in `fm-client.js`): `fmPost(pathSuffix, body)`, `fmFindRecords(layout, queries, opts)`, `fmGet(pathSuffix)`, `fmGetRecordById`, `ensureToken`.

## What was already changed (do NOT re-implement; debug/adjust only)

**`routes/catalog/featured.js`** (endpoints mounted at `/api` via `routes/catalog.js`):
- Added `SINGLES_TTL_MS` (defaults 10 min, env `SINGLES_CACHE_TTL_MS`).
- Added `SINGLES_FIELD_CANDIDATES = ['Tape Files::singles', 'singles', 'Tape Files::Singles', 'Singles']` and `SINGLES_VALUE = 'Yes'`.
- Added `trySinglesField()` + `fetchSinglesRecords()`. **Filters each record by `recordIsVisible(f) && hasValidAudio(f) && hasValidArtwork(f)`; no album dedupe (1 per track).**
- Added `singlesSwr = createSwrCache({...})` (SWR, 10-min TTL, key `'default'`).
- Added `singles: () => singlesSwr.get('default')` to `featuredWarmers`.
- Added route `GET /singles` → `{ ok, items, total }`. Supports `?limit=N` (default 40, max 200) and `?refresh=1` (deletes the SWR cache entry).

**`server.js`:**
- Added `'/singles'` to the auth **skip-list** (public, no token).
- Added `'/api/singles'` to `expensiveLimiter`.
- Added `prewarm('Singles', featuredWarmers.singles, 3500)`.

**`public/app.html`:**
- Added `<section class="section" id="singlesSection" hidden>` immediately after the New Releases section, containing `#singlesContainer` and the two `.scroll-arrow` buttons (`data-target="singlesContainer"`).
- Added a scoped `<style>` for `.mad-single-card` (fixed 150px cards, flex row).
- Added an IIFE `<script>` that fetches `/api/singles?limit=40`, renders cards, and on click does `window.MADPlayer.itemsStore.set(id, item); window.MADPlayer.playSong(id);`. It removes the `hidden` attribute only when `items.length > 0` (so the rail stays hidden if there's no data — by design).
- Added `singlesSection` to the search-mode visibility toggle in the “Search Results Heading toggle” IIFE (`updateHeadings`).

## Symptom
Running locally, the Singles rail does not appear. `singles` field reportedly added to FileMaker. Production is irrelevant (runs old code + the layout change may be local only).

## Two things to know before you start
- **Casing is not the issue.** The user's checkbox stores the value lowercase `yes`, but FileMaker `_find` is **case-insensitive**, so querying `"Yes"` matches `yes` fine. Don't chase casing.
- **Most likely cause of "route works but `items` is empty (despite records existing)":** the strict artwork filter. `fetchSinglesRecords` keeps a record only if `recordIsVisible(f) && hasValidAudio(f) && hasValidArtwork(f)`. If the tracks you ticked `singles` on don't have a valid `Artwork_S3_URL` (or valid `S3_URL`), they're silently dropped and the rail stays empty. This is covered in Step 3.3 — check it early; the fix is to relax the filter to visibility-only (like New Releases) if the records legitimately lack artwork.

## Debug plan — do these in order and report findings

### Step 1 — Is the route even loaded?
Restart the server, then:
```bash
curl -s "http://localhost:<PORT>/api/singles?refresh=1" | head -c 2000
```
- `404` → server didn’t load the new route. Confirm it’s running the edited `featured.js` (no stale process, correct entry file).
- `{"ok":true,"items":[]}` → route works, **0 records matched** → go to Step 3.
- `{"ok":true,"items":[ ... ]}` → backend is fine → go to Step 4 (front-end).

### Step 2 — Rule out the SWR cache
The 10-min SWR cache will serve an empty result if the endpoint was hit before the field existed. Always test with `?refresh=1`, or restart the process. If `refresh=1` suddenly returns items, that was it.

### Step 3 — Verify the field directly in FileMaker (when items is empty)
Write a throwaway script (run from the repo root so relative imports resolve) using the FM client. Two checks:

1. **Layout metadata** — confirm the field is on `API_Album_Songs` and its EXACT name:
   ```js
   const res = await fmGet(`/layouts/${encodeURIComponent(process.env.FM_LAYOUT)}`);
   const json = await res.json();
   const names = (json?.response?.fieldMetaData || []).map(f => f.name);
   console.log(names.filter(n => /single/i.test(n)));   // <-- exact field name(s)
   ```
   If this prints `[]`, the field is **not on the layout** — that's the whole problem. Add it to `API_Album_Songs` in Layout mode (like `Tape Files::Featured` is), save, exit.

2. **_find on the field** — confirm value + count + how many survive the filters:
   ```js
   const layout = process.env.FM_LAYOUT;
   for (const field of ['Tape Files::singles','singles','Tape Files::Singles','Singles']) {
     const r = await fmPost(`/layouts/${encodeURIComponent(layout)}/_find`,
                            { query:[{ [field]: 'Yes' }], limit: 5, offset: 1 });
     const j = await r.json();
     const code = j?.messages?.[0]?.code, found = j?.response?.dataInfo?.foundCount;
     console.log(field, '→ code', code, 'found', found);
     // For the first matching field, log a record's singles value + whether it has audio/artwork:
   }
   ```
   Interpret:
   - code `102` / "Field is missing" → wrong field name / not on layout.
   - code `401` / found `0` → field exists but **no records have `singles = Yes`** (tick some, or the stored value isn’t exactly `Yes`).
   - code `0`, found > 0 → field + value are good. Then the records are being dropped by the **`hasValidAudio` / `hasValidArtwork` filter** in `fetchSinglesRecords` (check `S3_URL` and `Artwork_S3_URL` on those records). See `lib/track.js` for `hasValidAudio`/`hasValidArtwork`/`resolveArtworkSrc`. **If the singles test records legitimately lack artwork, relax the filter** in `fetchSinglesRecords` (e.g. require only `recordIsVisible` + `hasValidAudio`, like New Releases does).

### Step 4 — Front-end (when `/api/singles` returns items but no rail shows)
- Hard-reload with cache disabled. Confirm you’re in **dev** mode (prod caches `app.html`).
- Browser console: look for `[Singles] load failed` or any JS error in the IIFE.
- In DevTools, confirm `<section id="singlesSection">` exists, and check whether it still has the `hidden` attribute. The loader sets `section.hidden = false` only when `items.length`. If `hidden` was removed but it’s still not visible, check the `updateHeadings` toggle (it sets `singlesSection.style.display`); make sure the home view’s `data-mode` isn’t flagged as a search mode.
- Confirm the section sits inside the same home-view container as `#newReleasesSection` (it was inserted right after it) so `showView('home'|'albums')` doesn’t hide it.
- Click a card → should call `window.MADPlayer.playSong(id)`. `playSong` early-returns if `!itemsStore.has(id)` (`isCardDisplayed`), so the loader must `itemsStore.set(id, item)` first — verify that line ran (it’s in the click handler).

## Acceptance
- `curl /api/singles?refresh=1` returns `ok:true` with one item per ticked track.
- Home page shows a "Singles" rail of track cards; clicking one plays it in the player bar; the rail hides during search.
- No console errors.

## Notes
- Don’t commit `.env`. Verify `git check-ignore .env` prints `.env` before any `git add`.
- The user owns the push; commit as `Ian Osrin <ian@digitalcupboard.net>` if asked to commit, but don’t push.
